import { type FC, useEffect, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCaretDown, faEye, faEyeSlash } from '@fortawesome/free-solid-svg-icons'
import type { Project } from '@shared/types'
import { ProjectIcon } from './ProjectIcon'

interface ProjectVisibilityMenuProps {
  projects: Project[]
  onToggle: (projectId: string, visible: boolean) => void
}

// The only place a hidden source can be found again: hiding it takes its row out
// of the Data list entirely.
export const ProjectVisibilityMenu: FC<ProjectVisibilityMenuProps> = ({ projects, onToggle }) => {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const hiddenCount = projects.filter((project) => !project.visible).length

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((value) => !value)}
        title="Show or hide sources"
        aria-expanded={open}
        className={`flex h-[30px] items-center gap-1.5 rounded-md border px-2.5 text-white/55 transition-colors cursor-pointer ${
          open ? 'border-holmes-primary/40 bg-white/[0.05] text-white/80' : 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:text-white/80'
        }`}
      >
        <FontAwesomeIcon icon={faEye} className="text-[13px]" />
        {hiddenCount > 0 && <span className="text-[10px] tabular-nums text-white/40">{hiddenCount}</span>}
        <FontAwesomeIcon icon={faCaretDown} className="text-[11px]" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 max-h-96 w-64 overflow-y-auto rounded-xl border border-white/10 bg-holmes-surface py-1 shadow-2xl scrollbar-thin">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-white/30">Source visibility</div>
          {projects.map((project) => (
            <button
              key={project.id}
              onClick={() => onToggle(project.id, !project.visible)}
              className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-white/[0.05] cursor-pointer"
            >
              <ProjectIcon icon={project.icon} className={`shrink-0 text-[13px] ${project.visible ? '' : 'opacity-40'}`} />
              <span className={`min-w-0 flex-1 truncate text-[13px] ${project.visible ? 'text-white/75' : 'text-white/35'}`}>
                {project.name}
              </span>
              <FontAwesomeIcon
                icon={project.visible ? faEye : faEyeSlash}
                className={`shrink-0 text-[12px] ${project.visible ? 'text-holmes-primary-light' : 'text-white/25'}`}
              />
            </button>
          ))}
          {projects.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-white/30">No sources yet.</div>
          )}
        </div>
      )}
    </div>
  )
}
