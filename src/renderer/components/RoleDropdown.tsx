import { type FC, useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faUserTie } from '@fortawesome/free-solid-svg-icons'
import { PillDropdown } from './PillDropdown'
import { ProjectIcon } from './ProjectIcon'
import type { RoleSummary } from '@shared/types'

interface RoleDropdownProps {
  value: string | null
  onChange: (roleId: string | null) => void
  disabled?: boolean
}

export const RoleDropdown: FC<RoleDropdownProps> = ({ value, onChange, disabled }) => {
  const [roles, setRoles] = useState<RoleSummary[]>([])

  useEffect(() => {
    window.electronAPI.roles
      .list()
      .then(setRoles)
      .catch(() => setRoles([]))
  }, [])

  const selected = roles.find((role) => role.id === value) ?? null

  const triggerIcon = selected ? (
    <ProjectIcon icon={selected.icon} className="text-[0.875rem]" style={{ color: selected.color }} />
  ) : (
    <FontAwesomeIcon icon={faUserTie} className="w-4 h-4" />
  )

  const renderPanel = (close: () => void) => (
    <div className="flex flex-col overflow-hidden">
      <div className="overflow-y-auto flex-1 scrollbar-thin py-1 max-h-80">
        <button
          onClick={() => {
            onChange(null)
            close()
          }}
          className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors cursor-pointer text-left ${
            selected === null
              ? 'bg-holmes-primary/20 text-holmes-primary-light'
              : 'text-white/70 hover:bg-white/5 hover:text-white'
          }`}
        >
          <span className="flex-1 truncate">None</span>
          <span className="text-[10px] text-white/30 shrink-0">no role</span>
        </button>
        {roles.length === 0 && (
          <div className="px-3 py-2 text-sm text-white/40">No roles available.</div>
        )}
        {roles.map((role) => (
          <button
            key={role.id}
            onClick={() => {
              onChange(role.id)
              close()
            }}
            className={`w-full flex flex-col gap-0.5 px-3 py-2 text-sm transition-colors cursor-pointer text-left ${
              role.id === value
                ? 'bg-holmes-primary/20 text-holmes-primary-light'
                : 'text-white/70 hover:bg-white/5 hover:text-white'
            }`}
          >
            <span className="flex items-center gap-2.5 w-full">
              <span className="flex items-center justify-center w-4 h-4 shrink-0">
                <ProjectIcon icon={role.icon} className="text-[0.875rem]" style={{ color: role.color }} />
              </span>
              <span className="flex-1 truncate">{role.name}</span>
              <span className="text-[10px] text-white/30 shrink-0">{role.specialty}</span>
            </span>
            <span className="pl-[26px] pr-1 text-[11px] leading-snug text-white/35">{role.description}</span>
          </button>
        ))}
      </div>
      {selected?.writesSessionNote && (
        <div className="border-t border-white/10 px-3 py-2 text-[11px] leading-snug text-white/40">
          When this conversation goes quiet, a session note is written from it and filed
          {selected.sessionProjectName ? ` under ${selected.sessionProjectName}` : ''}.
        </div>
      )}
    </div>
  )

  return (
    <PillDropdown
      icon={triggerIcon}
      label="Role"
      value={value ?? ''}
      // `renderPanel` draws the list; these exist so the pill's own label reads
      // the selected role's name rather than the fallback.
      options={roles.map((role) => ({ value: role.id, label: role.name }))}
      onSelect={(id) => onChange(id || null)}
      disabled={disabled}
      align="right"
      renderPanel={renderPanel}
    />
  )
}
