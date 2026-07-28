import { type FC, useCallback, useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faChevronDown, faChevronRight, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import type { RoleSessionNote, RoleSessionRisk } from '@shared/types'
import { MarkdownRenderer } from './MarkdownRenderer'

interface SessionNotesPanelProps {
  projectId: string
  onOpenConversation?: (conversationId: string) => void
}

const RISK_STYLES: Record<RoleSessionRisk, { label: string; className: string }> = {
  none: { label: 'No risk content', className: 'text-white/30 border-white/10' },
  monitor: { label: 'Monitor', className: 'text-amber-200/80 border-amber-400/25 bg-amber-400/[0.07]' },
  urgent: { label: 'Urgent', className: 'text-red-200/90 border-red-400/30 bg-red-400/10' },
}

export const SessionNotesPanel: FC<SessionNotesPanelProps> = ({ projectId, onOpenConversation }) => {
  const [notes, setNotes] = useState<RoleSessionNote[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    window.electronAPI.roles
      .listSessionNotes({ projectId })
      .then(setNotes)
      .catch(() => setNotes([]))
      .finally(() => setLoading(false))
  }, [projectId])

  useEffect(() => {
    load()
    // A note written by the background pass should appear without a reload.
    return window.electronAPI.roles.onSessionNoteAdded(load)
  }, [load])

  return (
    <section className="bg-holmes-surface rounded-2xl border border-violet-400/15 p-6 mb-6">
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h2 className="text-sm font-medium text-white/75 font-serif-display">Session Notes</h2>
          <p className="text-xs text-white/35 mt-1">
            Written automatically after each role-led conversation goes quiet, and read back into later sessions and the
            psychological profile.
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] uppercase tracking-wider text-white/25">Recorded</div>
          <div className="mt-0.5 text-[11px] text-white/45">{notes.length}</div>
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-white/30">Loading…</p>
      ) : notes.length === 0 ? (
        <p className="text-xs leading-relaxed text-white/35">
          No session notes yet. Pick a role from the Role pill in a conversation — a note is written when that
          conversation goes quiet.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {notes.map((note) => {
            const expanded = expandedId === note.id
            const risk = RISK_STYLES[note.risk] ?? RISK_STYLES.none
            return (
              <div key={note.id} className="rounded-xl border border-white/[0.07] bg-black/10 overflow-hidden">
                <button
                  onClick={() => setExpandedId(expanded ? null : note.id)}
                  className="w-full flex items-start gap-3 p-4 text-left hover:bg-white/[0.03] transition-colors cursor-pointer"
                >
                  <FontAwesomeIcon
                    icon={expanded ? faChevronDown : faChevronRight}
                    className="w-3 h-3 mt-1 text-white/25 shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] uppercase tracking-[0.14em] text-violet-300/65">{note.sessionDate}</span>
                      <span className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold tracking-[0.12em] ${risk.className}`}>
                        {note.risk !== 'none' && <FontAwesomeIcon icon={faTriangleExclamation} className="w-2.5 h-2.5 mr-1" />}
                        {risk.label.toUpperCase()}
                      </span>
                      <span className="text-[10px] text-white/25">{note.turns} turns</span>
                    </div>
                    <h3 className="mt-1 text-sm font-medium text-white/75 font-serif-display truncate">{note.title}</h3>
                    {!expanded && note.summary && (
                      <p className="mt-1 text-xs leading-relaxed text-white/40 line-clamp-2">{note.summary}</p>
                    )}
                  </div>
                </button>

                {expanded && (
                  <div className="px-4 pb-4">
                    {note.summary && (
                      <p className="text-xs leading-relaxed text-white/50 mb-4">{note.summary}</p>
                    )}
                    <div className="flex flex-col gap-3">
                      {note.sections.map((section) => (
                        <div key={section.key}>
                          <div className="text-[10px] uppercase tracking-[0.14em] text-white/30 mb-1">{section.heading}</div>
                          <div className="text-xs leading-relaxed text-white/55">
                            <MarkdownRenderer content={section.body} />
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 flex items-center gap-3 flex-wrap text-[10px] text-white/25">
                      {onOpenConversation && (
                        <button
                          onClick={() => onOpenConversation(note.conversationId)}
                          className="text-violet-300/65 hover:text-violet-200 transition-colors cursor-pointer"
                        >
                          Open conversation
                        </button>
                      )}
                      {note.filePath && <span className="truncate" title={note.filePath}>{note.filePath}</span>}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
          <p className="mt-2 text-[10px] leading-relaxed text-white/25">
            These notes are AI-generated from your own conversations. They are not clinical records, were not reviewed by
            a licensed clinician, and contain no diagnosis.
          </p>
        </div>
      )}
    </section>
  )
}
